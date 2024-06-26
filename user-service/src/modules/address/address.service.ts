import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AddressEntity, AddressSchema } from './address.entity';
import { ShopRepository } from '../shop/repository/shop.repository';
@Injectable()
export class AddressService {
  constructor(
    private readonly httpService: HttpService,
    @InjectModel(AddressEntity.name)
    private readonly addressModel: Model<AddressEntity>,
    private readonly shopRepository: ShopRepository,
  ) {}

  async parseAddressToString(
    cityId: string,
    districtId: string,
    wardId: string,
  ) {
    const city = await this.addressModel.findOne({ id: cityId });
    const district = await this.addressModel.findOne({ id: districtId });
    const ward = await this.addressModel.findOne({ id: wardId });
    return `${ward.name}, ${district.name}, ${city.name}`;
  }

  async getAddressRates(
    addressTo: {
      cityId: string;
      districtId: string;
    },
    shopId: string,
  ) {
    try {
      const shopAddress: any =
        await this.shopRepository.findAddressById(shopId);
      const addressFrom = {
        cityId: shopAddress.address.city,
        districtId: shopAddress.address.district,
      } as any;

      const res = await this.httpService.axiosRef({
        method: 'post',
        url: 'http://sandbox.goship.io/api/v2/rates',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.GOSHIP_API_TOKEN,
        },
        data: {
          shipment: {
            address_from: {
              city: addressFrom.cityId,
              district: addressFrom.districtId,
            },
            address_to: {
              city: addressTo.cityId,
              district: addressTo.districtId,
            },
            parcel: {
              cod: 0,
              amount: 0,
              width: 10,
              height: 10,
              length: 10,
              weight: 500,
            },
          },
        },
      });
      return res.data.data;
    } catch (err) {
      console.log('err', err);
    }
  }

  async getCities() {
    return await this.addressModel
      .find({ type: 'city' })
      .select('-createdAt -updatedAt -__v');
  }

  async getCitiesApi() {
    return this.httpService
      .axiosRef({
        method: 'get',
        url: 'http://sandbox.goship.io/api/v2/cities',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.GOSHIP_API_TOKEN,
        },
      })
      .then((res) => {
        return res.data.data;
      })
      .catch((err) => {
        console.log('err', err);
      });
  }

  async getDistricts(cityId: string) {
    return await this.addressModel
      .find({ type: 'district', city_id: cityId })
      .select('-createdAt -updatedAt -__v');
  }

  async getDistrictsApi(cityId: string) {
    return this.httpService
      .axiosRef({
        method: 'get',
        url: `http://sandbox.goship.io/api/v2/cities/${cityId}/districts`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.GOSHIP_API_TOKEN,
        },
      })
      .then((res) => {
        return res.data.data;
      })
      .catch((err) => {
        console.log('err', err);
      });
  }

  async getWards(districtId: string) {
    return await this.addressModel
      .find({ type: 'ward', district_id: districtId })
      .select('-createdAt -updatedAt -__v');
  }

  async getWardsApi(districtId: string) {
    return this.httpService
      .axiosRef({
        method: 'get',
        url: `http://sandbox.goship.io/api/v2/districts/${districtId}/wards`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.GOSHIP_API_TOKEN,
        },
      })
      .then((res) => {
        return res.data.data;
      })
      .catch((err) => {
        console.log('err', err);
      });
  }

  async crawAddressData() {
    await this.addressModel.deleteMany({});
    const cities = await this.getCitiesApi();
    let willSaveData = [];
    for (const city of cities) {
      willSaveData.push({
        id: city.id,
        type: 'city',
        name: city.name,
      });
      await this.delay(300);
      const districts = await this.getDistrictsApi(city.id);
      for (const district of districts) {
        willSaveData.push({
          id: district.id,
          type: 'district',
          name: district.name,
          city_id: city.id,
        });
        await this.delay(300);
        const wards = await this.getWardsApi(district.id);
        for (const ward of wards) {
          willSaveData.push({
            id: ward.id,
            type: 'ward',
            name: ward.name,
            district_id: district.id,
          });
        }
      }
    }
    return await this.addressModel.insertMany(willSaveData);
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
